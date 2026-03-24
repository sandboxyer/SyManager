import Component from "./Component.js";

class Group extends Component {

    static async New(name = 'New Group'){
        return await this.Model.create({Name : name,Type : 'group'})
    }

}

export default Group