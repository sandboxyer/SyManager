import Component from "./Component.js";

class Group extends Component {

    static async New(name){
        return await this.Model.create({Name : name,Type : 'group'})
    }

}

export default Group